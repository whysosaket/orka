package server

import (
	"context"
	"fmt"
	"sort"
	"strings"
)

type MemoryResolver interface {
	Resolve(context.Context, Object) ([]Object, error)
}

func memoryUnavailable(code string) error {
	return &HTTPError{Status: 503, Message: "Memory consolidation pending: " + code}
}

type taggedEdit struct {
	TextEdit
	side string
}
type memoryPart struct {
	start, end              int
	base, current, incoming string
	resolved                *string
}

func bothTexts(current, incoming string) string {
	if current == "" {
		return incoming
	}
	if incoming == "" || current == incoming {
		return current
	}
	if !strings.HasSuffix(current, "\n") {
		current += "\n"
	}
	return current + incoming
}
func memoryPlan(base, current, incoming string) []memoryPart {
	original := textLines(base)
	pending := []taggedEdit{}
	for _, edit := range DiffText(base, current) {
		pending = append(pending, taggedEdit{edit, "current"})
	}
	for _, edit := range DiffText(base, incoming) {
		pending = append(pending, taggedEdit{edit, "incoming"})
	}
	sort.SliceStable(pending, func(i, j int) bool {
		if pending[i].Start != pending[j].Start {
			return pending[i].Start < pending[j].Start
		}
		return pending[i].End < pending[j].End
	})
	parts := []memoryPart{}
	for len(pending) > 0 {
		group := []taggedEdit{pending[0]}
		pending = pending[1:]
		for i := 0; i < len(pending); {
			overlap := false
			for _, edit := range group {
				overlap = overlap || editsOverlap(edit.TextEdit, pending[i].TextEdit, true)
			}
			if overlap {
				group = append(group, pending[i])
				pending = append(pending[:i], pending[i+1:]...)
				i = 0
			} else {
				i++
			}
		}
		start, end := group[0].Start, group[0].End
		accepted, proposed := []TextEdit{}, []TextEdit{}
		insertions, deletions, noReplacement := true, true, true
		for _, edit := range group {
			start = min(start, edit.Start)
			end = max(end, edit.End)
			insertions = insertions && edit.Start == edit.End
			deletions = deletions && len(edit.Lines) == 0
			if edit.side == "current" {
				accepted = append(accepted, edit.TextEdit)
			} else {
				proposed = append(proposed, edit.TextEdit)
				noReplacement = noReplacement && !(edit.End > edit.Start && len(edit.Lines) > 0)
			}
		}
		part := memoryPart{start: start + 1, end: end + 1, base: strings.Join(original[start:end], ""), current: applyEdits(original, start, end, accepted), incoming: applyEdits(original, start, end, proposed)}
		resolved := ""
		known := true
		switch {
		case len(proposed) == 0 || part.current == part.incoming:
			resolved = part.current
		case insertions:
			resolved = bothTexts(part.current, part.incoming)
		case noReplacement && (len(accepted) == 0 || deletions):
			resolved = part.incoming
		default:
			known = false
		}
		if known {
			part.resolved = &resolved
		}
		if len(parts) > 0 && part.resolved == nil && parts[len(parts)-1].resolved == nil && parts[len(parts)-1].end == part.start {
			previous := &parts[len(parts)-1]
			previous.end = part.end
			previous.base += part.base
			previous.current += part.current
			previous.incoming += part.incoming
		} else {
			parts = append(parts, part)
		}
	}
	return parts
}
func ConsolidateMemory(ctx context.Context, base, current, incoming string, details Object, resolver MemoryResolver) (string, []any, error) {
	resolutions := []any{}
	if incoming == base || incoming == current {
		return current, resolutions, nil
	}
	parts := memoryPlan(base, current, incoming)
	conflicts := []any{}
	for _, part := range parts {
		if part.resolved == nil {
			conflicts = append(conflicts, Object{"startLine": part.start, "endLine": part.end, "base": part.base, "current": part.current, "incoming": part.incoming})
		}
	}
	answers := []Object{}
	if len(conflicts) > 0 {
		var err error
		answers, err = resolver.Resolve(ctx, Object{"context": details, "base": base, "current": current, "incoming": incoming, "conflicts": conflicts})
		if err != nil {
			return "", nil, err
		}
	}
	if len(answers) != len(conflicts) {
		return "", nil, memoryUnavailable("invalid_answers")
	}
	original := textLines(base)
	position, index := 0, 0
	var result strings.Builder
	for _, part := range parts {
		resolved := ""
		if part.resolved != nil {
			resolved = *part.resolved
		} else {
			answer := answers[index]
			index++
			switch text(answer["choice"]) {
			case "keep_current":
				resolved = part.current
			case "accept_incoming":
				resolved = part.incoming
			case "keep_both":
				resolved = bothTexts(part.current, part.incoming)
			default:
				return "", nil, memoryUnavailable("invalid_answers")
			}
			resolutions = append(resolutions, merge(Object{"path": details["logicalPath"], "startLine": part.start, "endLine": part.end}, answer))
		}
		if part.start-1 < position {
			return "", nil, fmt.Errorf("overlapping consolidation plan")
		}
		result.WriteString(strings.Join(original[position:part.start-1], ""))
		result.WriteString(resolved)
		position = part.end - 1
	}
	result.WriteString(strings.Join(original[position:], ""))
	return result.String(), resolutions, nil
}
