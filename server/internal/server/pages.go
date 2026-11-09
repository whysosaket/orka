package server

import (
	"embed"
	"html"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

//go:embed templates/*.html
var pageFiles embed.FS

func renderPage(name string, values map[string]string) []byte {
	data, _ := pageFiles.ReadFile("templates/" + name)
	page := string(data)
	for key, value := range values {
		page = strings.ReplaceAll(page, "{{"+key+"}}", value)
	}
	return []byte(page)
}
func (a *API) invitePage(w http.ResponseWriter, r *http.Request) error {
	title, description, content, status := "Invite unavailable", "This invite has expired or was already used. Ask the project owner for a new invite.", "", 200
	if !includes([]string{http.MethodGet, http.MethodHead}, r.Method) {
		status = 405
		w.Header().Set("Allow", "GET, HEAD")
		description = "Open the original project invite in your browser."
	} else {
		parts := regexp.MustCompile(`^/join/([a-f0-9]{48})$`).FindStringSubmatch(r.URL.Path)
		if len(parts) != 2 || r.URL.RawQuery != "" {
			status = 400
			description = "This invite link is invalid. Ask the project owner for a new invite."
		} else {
			var project Object
			_, err := a.Store.read(r.Context(), func(q *Queries) any {
				project = q.One("select p.name from orka.invites i join orka.projects p on p.id=i.project_id where i.token_hash=$1 and i.expires_at>now() and p.archived_at is null", bytesHash([]byte(parts[1])))
				return nil
			})
			if err != nil {
				return err
			}
			if project == nil {
				status = 410
			} else {
				title = "Join " + text(project["name"])
				description = "Open Orka to sign in, review what to share from this Mac, and join the project."
				desktop := "orka://join/" + parts[1] + "?" + url.Values{"server": []string{a.Settings.PublicURL}}.Encode()
				browser := a.Settings.PublicURL + "/join/" + parts[1]
				content = `<a class="button" href="` + escapeHTML(desktop) + `">Open Orka</a><p>Don’t have Orka? Install it on your Mac, then return to this page.</p><label for="invite">Invite link</label><textarea id="invite" rows="3" readonly spellcheck="false">` + escapeHTML(browser) + `</textarea><p class="hint">If Orka doesn’t open, copy this link and paste it into Join project in the app. Invites work once and expire after 24 hours.</p><p class="hint">Service: ` + escapeHTML(a.Settings.PublicURL) + `</p>`
			}
		}
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("X-Robots-Tag", "noindex, nofollow, noarchive")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
	w.WriteHeader(status)
	_, err := w.Write(renderPage("invite.html", map[string]string{"TITLE": escapeHTML(title), "DESCRIPTION": escapeHTML(description), "CONTENT": content}))
	return err
}

func escapeHTML(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(html.EscapeString(s), "&#34;", "&quot;"), "&#39;", "&#039;")
}

//go:embed templates/oauth.html
var oauthTemplate string
