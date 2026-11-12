package server

import (
	"context"
	"crypto/subtle"
	"net/http"
)

const dashboardBridgePrefix = "/internal/dashboard"

type dashboardContextKey struct{}

func fromDashboard(r *http.Request) bool {
	trusted, _ := r.Context().Value(dashboardContextKey{}).(bool)
	return trusted
}

func (s AuthSettings) dashboardRequest(r *http.Request, path string) *http.Request {
	if s.Mode != "cloud" || s.DashboardURL == "" || s.dashboardKey == "" ||
		subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Orka-Dashboard-Key")), []byte(s.dashboardKey)) != 1 {
		return nil
	}

	allowed := false
	switch r.Method {
	case http.MethodGet:
		allowed = includes([]string{"/v2/instance", "/auth/authorize", "/auth/callback", "/auth/verify", "/authorize"}, path) || invitePath.MatchString(path)
	case http.MethodPost:
		allowed = includes([]string{"/auth/otp", "/auth/token", "/auth/logout", "/mcp/connect"}, path)
	}
	if !allowed {
		return nil
	}

	bridge := r.Clone(context.WithValue(r.Context(), dashboardContextKey{}, true))
	bridge.URL.Path, bridge.URL.RawPath = path, ""
	bridge.RequestURI = bridge.URL.RequestURI()
	bridge.Header.Del("X-Orka-Dashboard-Key")
	return bridge
}
