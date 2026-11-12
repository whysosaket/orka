package server

import (
	"reflect"
	"testing"
)

func TestReadableSessionsRetainRepeatedTurnsAndExcludePrivateSetup(t *testing.T) {
	message := func(role, content string) Object {
		return Object{"type": "response_item", "payload": Object{"type": "message", "role": role, "content": []Object{{"type": "input_text", "text": content}}}}
	}
	records := []Object{
		{"type": "session_meta", "payload": Object{}},
		message("user", "# AGENTS.md instructions\n<INSTRUCTIONS>Private setup</INSTRUCTIONS>"),
		message("user", "<environment_context>setup</environment_context>\n## My request:\nFix login"),
		{"type": "response_item", "payload": Object{"role": "assistant", "channel": "analysis", "content": "Hidden reasoning"}},
		{"type": "response_item", "payload": Object{"type": "function_call_output", "output": "PRIVATE_TOOL_DATA"}},
		message("assistant", "Use PKCE"),
		{"type": "event_msg", "payload": Object{"type": "agent_message", "message": "Use PKCE"}},
		{"type": "event_msg", "payload": Object{"type": "task_started"}},
		message("user", "Fix login"), message("assistant", "Use PKCE"),
	}
	want := []SessionMessage{{"user", "Fix login"}, {"assistant", "Use PKCE"}, {"user", "Fix login"}, {"assistant", "Use PKCE"}}
	if got := SessionMessages(records); !reflect.DeepEqual(got, want) {
		t.Fatalf("readable turns changed: %+v", got)
	}
	records = []Object{
		{"type": "user", "message": Object{"content": "Help with onboarding"}},
		{"type": "user", "message": Object{"content": []Object{{"type": "tool_result", "content": "not a user message"}}}},
		{"type": "user", "isMeta": true, "message": Object{"content": "Injected setup"}},
		{"type": "assistant", "message": Object{"content": []Object{{"type": "thinking", "thinking": "hidden"}, {"type": "text", "text": "Start with email"}}}},
	}
	want = []SessionMessage{{"user", "Help with onboarding"}, {"assistant", "Start with email"}}
	if got := SessionMessages(records); !reflect.DeepEqual(got, want) {
		t.Fatalf("Claude turns changed: %+v", got)
	}
}
