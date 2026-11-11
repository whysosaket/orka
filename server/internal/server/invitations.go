package server

import (
	"bytes"
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"mime/multipart"
	"mime/quotedprintable"
	"net"
	"net/http"
	"net/mail"
	"net/smtp"
	"net/textproto"
	"strconv"
	"strings"
	"time"
)

func normalizeInvitationEmail(value string) (string, error) {
	value = strings.ToLower(strings.TrimSpace(value))
	address, err := mail.ParseAddress(value)
	_, domain, _ := strings.Cut(value, "@")
	if err != nil || address.Address != value || len(value) > 254 || !strings.Contains(domain, ".") {
		return "", bad("Enter a valid email address")
	}
	return value, nil
}

func (a *API) invitationEmailAvailable() bool {
	if a.Settings.PublicURL == "" {
		return false
	}
	if a.Settings.EmailProvider == "resend" {
		return a.Environment["RESEND_API_KEY"] != "" && a.Environment["RESEND_FROM"] != ""
	}
	return a.Environment["SMTP_HOST"] != "" && a.Environment["SMTP_FROM"] != ""
}

func invitationContent(project, link, to string) (string, string) {
	plain := fmt.Sprintf("You've been invited to join %s on Orka.\n\n%s\n\nSign in with %s, then review and confirm joining in Orka. This invitation expires in 24 hours and can be used once. If you weren't expecting it, ignore this email.", project, link, to)
	content := `<p>You've been invited to join <strong>` + escapeHTML(project) + `</strong> on Orka.</p><p><a href="` + escapeHTML(link) + `">Join project</a></p><p>Sign in with ` + escapeHTML(to) + `, then review and confirm joining in Orka.</p><p>This invitation expires in 24 hours and can be used once. If you weren't expecting it, ignore this email.</p>`
	return plain, content
}

func invitationMessage(from, to, project, link string) ([]byte, string, error) {
	sender, err := mail.ParseAddress(from)
	if err != nil {
		return nil, "", err
	}
	plain, content := invitationContent(project, link, to)
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for _, part := range []struct{ kind, content string }{{"text/plain", plain}, {"text/html", content}} {
		headers := textproto.MIMEHeader{"Content-Type": {part.kind + `; charset="utf-8"`}, "Content-Transfer-Encoding": {"quoted-printable"}}
		output, err := writer.CreatePart(headers)
		if err != nil {
			return nil, "", err
		}
		encoded := quotedprintable.NewWriter(output)
		if _, err = encoded.Write([]byte(part.content)); err != nil {
			return nil, "", err
		}
		if err = encoded.Close(); err != nil {
			return nil, "", err
		}
	}
	if err = writer.Close(); err != nil {
		return nil, "", err
	}
	header := fmt.Sprintf("Date: %s\r\nFrom: %s\r\nTo: %s\r\nSubject: You're invited to a project on Orka\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary=%q\r\n\r\n", time.Now().Format(time.RFC1123Z), sender.String(), to, writer.Boundary())
	return append([]byte(header), body.Bytes()...), sender.Address, nil
}

func (a *API) sendInvitation(ctx context.Context, email, project, link, hash string) error {
	fail := &HTTPError{Status: 503, Message: "Invitation email delivery could not be confirmed. Try again in a minute or use a joining link."}
	if a.Settings.EmailProvider == "resend" {
		base := a.Environment["RESEND_API_URL"]
		if base == "" {
			base = "https://api.resend.com"
		}
		plain, content := invitationContent(project, link, email)
		response, err := requestHTTP(ctx, http.MethodPost, strings.TrimSuffix(base, "/")+"/emails", jsonBytes(Object{"from": a.Environment["RESEND_FROM"], "to": email, "subject": "You're invited to a project on Orka", "text": plain, "html": content}), http.Header{"Authorization": {"Bearer " + a.Environment["RESEND_API_KEY"]}, "Content-Type": {"application/json"}, "Idempotency-Key": {"orka-invite-" + hash}}, 10*time.Second)
		if err != nil {
			return fail
		}
		defer response.Body.Close()
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return fail
		}
		return nil
	}
	if err := a.sendSMTPInvitation(ctx, email, project, link); err != nil {
		return fail
	}
	return nil
}

func (a *API) sendSMTPInvitation(ctx context.Context, email, project, link string) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	host, port := a.Environment["SMTP_HOST"], a.Environment["SMTP_PORT"]
	if port == "" {
		port = "587"
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return fmt.Errorf("invalid SMTP port")
	}
	message, from, err := invitationMessage(a.Environment["SMTP_FROM"], email, project, link)
	if err != nil {
		return err
	}
	conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", net.JoinHostPort(host, port))
	if err != nil {
		return err
	}
	defer conn.Close()
	deadline, _ := ctx.Deadline()
	if err = conn.SetDeadline(deadline); err != nil {
		return err
	}
	tlsConfig := &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12}
	if port == "465" {
		secured := tls.Client(conn, tlsConfig)
		if err = secured.HandshakeContext(ctx); err != nil {
			return err
		}
		conn = secured
	}
	client, err := smtp.NewClient(conn, host)
	if err != nil {
		return err
	}
	defer client.Close()
	if port != "465" {
		if ok, _ := client.Extension("STARTTLS"); ok {
			if err = client.StartTLS(tlsConfig); err != nil {
				return err
			}
		}
	}
	if user := a.Environment["SMTP_USER"]; user != "" {
		if err = client.Auth(smtp.PlainAuth("", user, a.Environment["SMTP_PASSWORD"], host)); err != nil {
			return err
		}
	}
	if err = client.Mail(from); err != nil {
		return err
	}
	if err = client.Rcpt(email); err != nil {
		return err
	}
	output, err := client.Data()
	if err != nil {
		return err
	}
	if _, err = output.Write(message); err != nil {
		return err
	}
	if err = output.Close(); err != nil {
		return err
	}
	// DATA acceptance is success even if the peer closes before QUIT.
	_ = client.Quit()
	return nil
}

func (a *API) invitationAccountEmail(ctx context.Context, token, user string) (string, error) {
	if a.AuthURL == "" {
		return "", nil
	}
	response, err := requestHTTP(ctx, http.MethodGet, strings.TrimSuffix(a.AuthURL, "/")+"/user", nil, http.Header{"Authorization": {"Bearer " + token}}, 10*time.Second)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", &HTTPError{Status: 401, Message: "Session expired"}
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 1_000_000))
	if err != nil {
		return "", err
	}
	value, err := decode(raw)
	if err != nil {
		return "", err
	}
	account := object(value)
	if text(account["id"]) != user || text(account["email_confirmed_at"]) == "" {
		return "", nil
	}
	email, _ := normalizeInvitationEmail(text(account["email"]))
	return email, nil
}
