package server

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
)

type memoryResolverFunc func(context.Context, Object) ([]Object, error)

func (f memoryResolverFunc) Resolve(ctx context.Context, state Object) ([]Object, error) {
	return f(ctx, state)
}

func memoryAnswer(choice string) Object {
	probabilities := Object{"keep_current": 0.05, "accept_incoming": 0.05, "keep_both": 0.05}
	probabilities[choice] = 0.9
	return Object{"model": jevModel, "choice": choice, "confidence": 0.9, "probabilities": probabilities}
}

func memoryDetails() Object {
	return Object{"logicalPath": "claude/MEMORY.md", "title": "Project memory", "source": "claude", "baseRevision": 1, "currentRevision": 2, "incomingAuthor": "teammate", "currentAuthor": "owner"}
}

func TestDeterministicMemoryEditsBypassInference(t *testing.T) {
	resolver := memoryResolverFunc(func(context.Context, Object) ([]Object, error) {
		t.Error("deterministic edit invoked inference")
		return nil, errors.New("unexpected inference")
	})
	cases := [][4]string{
		{"", "", "new\n", "new\n"},
		{"a\nb\n", "a\nb\n", "a\nb\nc\n", "a\nb\nc\n"},
		{"a\nb\nc\n", "a\nb\nc\n", "a\nc\n", "a\nc\n"},
		{"a\nb\nc\n", "a\nb\nc\nd\n", "a\nc\n", "a\nc\nd\n"},
		{"a\nb\n", "A\nb\n", "a\nb\n", "A\nb\n"},
		{"a\nb\n", "A\nb\n", "A\nb\n", "A\nb\n"},
		{"a\nb\nc\n", "a\nc\n", "a\nc\n", "a\nc\n"},
		{"", "current\n", "incoming\n", "current\nincoming\n"},
		{"a\nb\n", "a\nfirst\nb\n", "a\nsecond\nb\n", "a\nfirst\nsecond\nb\n"},
		{"a\nb\n", "a\nnew\nb\n", "a\nnew\nb\n", "a\nnew\nb\n"},
	}
	for i, c := range cases {
		got, resolutions, err := ConsolidateMemory(context.Background(), c[0], c[1], c[2], memoryDetails(), resolver)
		if err != nil || got != c[3] || len(resolutions) != 0 {
			t.Errorf("case %d: %q, %v, %v", i, got, resolutions, err)
		}
	}
}

func TestMemoryReplacementIncludesFullContext(t *testing.T) {
	base, incoming := "# Deploy\nUse Node 22.\nRun npm test.\n", "# Deploy\nUse Node 24 for the backend.\nRun npm test.\n"
	calls := 0
	resolver := memoryResolverFunc(func(_ context.Context, state Object) ([]Object, error) {
		calls++
		if state["base"] != base || !reflect.DeepEqual(state["context"], memoryDetails()) {
			t.Errorf("missing context: %v", state)
		}
		want := []Object{{"startLine": 2, "endLine": 3, "base": "Use Node 22.\n", "current": "Use Node 22.\n", "incoming": "Use Node 24 for the backend.\n"}}
		if Canonical(state["conflicts"]) != Canonical(want) {
			t.Errorf("wrong conflicts: %v", state["conflicts"])
		}
		return []Object{memoryAnswer("accept_incoming")}, nil
	})
	got, resolutions, err := ConsolidateMemory(context.Background(), base, base, incoming, memoryDetails(), resolver)
	if err != nil || got != incoming || calls != 1 || len(resolutions) != 1 || field(resolutions[0], "path") != "claude/MEMORY.md" || field(resolutions[0], "choice") != "accept_incoming" {
		t.Fatalf("replacement: %q %v %v", got, resolutions, err)
	}
}

func TestMemoryConflictChoicesPreserveUnrelatedEdits(t *testing.T) {
	cases := []struct {
		base, current, incoming, choice, want string
		conflicts                             int
	}{
		{"a\nb\nc\n", "a\ncurrent\nc\n", "a\nincoming\nc\n", "keep_current", "a\ncurrent\nc\n", 1},
		{"a\nb\nc\n", "a\ncurrent\nc\n", "a\nincoming\nc\n", "accept_incoming", "a\nincoming\nc\n", 1},
		{"a\nb\nc\n", "a\ncurrent\nc\n", "a\nincoming\nc\n", "keep_both", "a\ncurrent\nincoming\nc\n", 1},
		{"old", "current", "incoming", "keep_both", "current\nincoming", 1},
		{"a\nb\nc\n", "a\nB\nc\n", "a\nc\n", "keep_current", "a\nB\nc\n", 1},
		{"a\nb\nc\n", "a\nB\nc\n", "a\nc\n", "accept_incoming", "a\nc\n", 1},
		{"a\nb\nc\n", "a\nc\n", "a\nB\nc\n", "accept_incoming", "a\nB\nc\n", 1},
		{"a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n", "accept_incoming", "A\nb\nC\n", 1},
		{"a\nb\nc\n", "a\ninserted\nb\nc\n", "a\nB\nc\n", "accept_incoming", "a\ninserted\nB\nc\n", 1},
		{"a\nb\nc\nd\n", "a\nB\nC\nd\n", "a\nb\nnew C\nd\n", "keep_current", "a\nB\nC\nd\n", 1},
		{"a\nb\nc\nd\n", "a\nB\nC\nd\n", "a\nb\nnew C\nd\n", "accept_incoming", "a\nB\nnew C\nd\n", 1},
		{"a\nb\nc\nd\n", "a\nb\nc\nd\n", "a\nB\nC\nextra\nd\n", "keep_current", "a\nb\nc\nextra\nd\n", 1},
	}
	for i, c := range cases {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			resolver := memoryResolverFunc(func(_ context.Context, state Object) ([]Object, error) {
				answers := []Object{}
				for range array(state["conflicts"]) {
					answers = append(answers, memoryAnswer(c.choice))
				}
				return answers, nil
			})
			got, resolutions, err := ConsolidateMemory(context.Background(), c.base, c.current, c.incoming, memoryDetails(), resolver)
			if err != nil || got != c.want || len(resolutions) != c.conflicts {
				t.Fatalf("merge: %q %v %v", got, resolutions, err)
			}
		})
	}
	calls := 0
	resolver := memoryResolverFunc(func(_ context.Context, state Object) ([]Object, error) {
		calls++
		if len(array(state["conflicts"])) != 2 {
			t.Error("conflicts not batched")
		}
		return []Object{memoryAnswer("keep_both"), memoryAnswer("accept_incoming")}, nil
	})
	got, _, err := ConsolidateMemory(context.Background(), "a\nb\nc\nd\ne\n", "a\nB\nc\nd\ne\n", "a\nnew B\nc\nd\nnew E\n", memoryDetails(), resolver)
	if err != nil || calls != 1 || got != "a\nB\nnew B\nc\nd\nnew E\n" {
		t.Fatalf("batch: %q %v", got, err)
	}
	empty := memoryResolverFunc(func(context.Context, Object) ([]Object, error) { return nil, nil })
	if _, _, err := ConsolidateMemory(context.Background(), "old\n", "old\n", "new\n", memoryDetails(), empty); err == nil || !strings.Contains(err.Error(), "invalid_answers") {
		t.Fatal("missing resolution accepted")
	}
}

func jevState() Object {
	return Object{"context": memoryDetails(), "base": "old\n", "current": "current\n", "incoming": "new\n", "conflicts": []Object{{"startLine": 1, "endLine": 2, "base": "old\n", "current": "current\n", "incoming": "new\n"}}}
}
func jevBody() Object {
	return Object{"model": jevModel, "usage": Object{"input_tokens": 100, "output_tokens": 20}, "answers": Object{"conflict_0": merge(memoryAnswer("accept_incoming"), Object{"type": "choice"})}}
}

type jevTransportFunc func(*http.Request) (*http.Response, error)

func (f jevTransportFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestJevProviderContractAndLimits(t *testing.T) {
	env := map[string]string{"TYPESAFE_API_KEY": "alias"}
	settings, err := memorySettings(env)
	if err != nil || !settings.Enabled || settings.APIKey != "alias" {
		t.Fatal("memory defaults changed")
	}
	env["JEV_API_KEY"] = " primary "
	settings, err = memorySettings(env)
	if err != nil || settings.APIKey != "primary" {
		t.Fatal("primary key precedence changed")
	}
	if _, err := memorySettings(map[string]string{"MEMORY_JEV_ENABLED": "yes"}); err == nil {
		t.Fatal("invalid enable flag accepted")
	}
	large := jevState()
	large["base"] = strings.Repeat("x", 24001)
	for _, c := range []struct {
		resolver JevResolver
		state    Object
		want     string
	}{
		{JevResolver{Enabled: true}, jevState(), "missing_key"},
		{JevResolver{APIKey: "x"}, jevState(), "disabled"},
		{JevResolver{Enabled: true, APIKey: "x"}, large, "context_limit"},
	} {
		if _, err := c.resolver.Resolve(context.Background(), c.state); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Fatalf("expected %s: %v", c.want, err)
		}
	}
	resolver := JevResolver{Enabled: true, APIKey: "test-key", Client: &http.Client{Transport: jevTransportFunc(func(req *http.Request) (*http.Response, error) {
		if req.URL.String() != "https://api.typesafe.ai/v1/systemone" || req.Header.Get("Authorization") != "Bearer test-key" {
			t.Error("provider endpoint/auth changed")
		}
		if _, ok := req.Context().Deadline(); !ok {
			t.Error("no request deadline")
		}
		raw, _ := io.ReadAll(req.Body)
		value, _ := decode(raw)
		body := object(value)
		if body["model"] != jevModel || Canonical(body["state"]) != Canonical(jevState()) || len(object(body["questions"])) != 1 || !strings.Contains(text(field(field(body["questions"], "conflict_0"), "instructions")), "conflicts[0]") {
			t.Errorf("invalid provider contract: %s", raw)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(jsonBytes(jevBody())))), Header: http.Header{}}, nil
	})}}
	answers, err := resolver.Resolve(context.Background(), jevState())
	if err != nil || len(answers) != 1 || answers[0]["choice"] != "accept_incoming" {
		t.Fatalf("valid provider reply: %v %v", answers, err)
	}
}

func TestJevFailuresRemainPrivateAndRetriesAreBounded(t *testing.T) {
	for _, status := range []int{401, 422, 429, 529, 503} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			attempts := 0
			resolver := JevResolver{Enabled: true, APIKey: "fixture", Client: &http.Client{Transport: jevTransportFunc(func(*http.Request) (*http.Response, error) {
				attempts++
				return &http.Response{StatusCode: status, Header: http.Header{"Retry-After": {"0"}}, Body: io.NopCloser(strings.NewReader("PRIVATE"))}, nil
			})}}
			_, err := resolver.Resolve(context.Background(), jevState())
			want := 2
			if status == 401 || status == 422 {
				want = 1
			}
			if err == nil || strings.Contains(err.Error(), "PRIVATE") || attempts != want {
				t.Fatalf("failure leaked/retry changed: %v %d", err, attempts)
			}
		})
	}
	for _, network := range []bool{false, true} {
		attempts := 0
		resolver := JevResolver{Enabled: true, APIKey: "fixture", Client: &http.Client{Transport: jevTransportFunc(func(*http.Request) (*http.Response, error) {
			attempts++
			if attempts == 1 {
				if network {
					return nil, errors.New("PRIVATE network failure")
				}
				return &http.Response{StatusCode: 529, Header: http.Header{"Retry-After": {"0"}}, Body: io.NopCloser(strings.NewReader(""))}, nil
			}
			return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(jsonBytes(jevBody()))))}, nil
		})}}
		answers, err := resolver.Resolve(context.Background(), jevState())
		if err != nil || len(answers) != 1 || attempts != 2 {
			t.Fatalf("transient recovery: %v %d", err, attempts)
		}
	}
	attempts := 0
	resolver := JevResolver{Enabled: true, APIKey: "fixture", Client: &http.Client{Transport: jevTransportFunc(func(req *http.Request) (*http.Response, error) {
		attempts++
		<-req.Context().Done()
		return nil, errors.New("PRIVATE timeout")
	})}}
	start := time.Now()
	if _, err := resolver.Resolve(context.Background(), jevState()); err == nil || !strings.Contains(err.Error(), "jev_network") || strings.Contains(err.Error(), "PRIVATE") || attempts != 1 || time.Since(start) > 6500*time.Millisecond {
		t.Fatalf("deadline/retry changed: %v %d", err, attempts)
	}
}

func TestJevRejectsRedirects(t *testing.T) {
	destination := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("provider redirect followed") }))
	defer destination.Close()
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, destination.URL, 302) }))
	defer provider.Close()
	resolver := JevResolver{Enabled: true, APIKey: "fixture", URL: provider.URL}
	if _, err := resolver.Resolve(context.Background(), jevState()); err == nil {
		t.Fatal("provider redirect accepted")
	}
}
