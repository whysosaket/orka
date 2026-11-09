package server

import (
	"fmt"

	browserurl "github.com/nlnwa/whatwg-url/url"
)

// Match browser origin serialization for HTTP(S) hosts used by OAuth bindings.
func canonicalOrigin(raw string) (string, error) {
	u, err := parseHTTPURL(raw)
	if err != nil {
		return "", err
	}
	return u.Scheme() + "://" + u.Host(), nil
}

func parseHTTPURL(raw string) (*browserurl.Url, error) {
	u, err := browserurl.Parse(raw)
	if err != nil || u.Hostname() == "" || u.Scheme() != "http" && u.Scheme() != "https" {
		return nil, fmt.Errorf("invalid HTTP origin")
	}
	return u, nil
}
