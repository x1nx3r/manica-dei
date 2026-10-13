package handlers

import (
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
)

// Hand-rolled metrics: counters only, rendered in the Prometheus text
// exposition format so the service keeps a /metrics surface with nothing
// vendored behind it.
//
//	http_requests_total{handler,method,code}
//	upload_mime_total{mime}
//	upload_bytes_total
//	upload_failures_total{reason}
//
// Declared is not the same as moving. /metrics renders every name it knows,
// including ones nothing increments yet.
var (
	metricsMu sync.Mutex
	counters  = map[string]map[string]float64{}
)

// Add increments the counter `name` by v for the given label set.
func Add(name string, v float64, labels map[string]string) {
	key := labelsKey(labels)
	metricsMu.Lock()
	defer metricsMu.Unlock()
	if counters[name] == nil {
		counters[name] = map[string]float64{}
	}
	counters[name][key] += v
}

// With increments the counter `name` by one.
func With(name string, labels map[string]string) {
	Add(name, 1, labels)
}

// MetricsHandler renders every counter in the exposition format.
func MetricsHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		metricsMu.Lock()
		names := make([]string, 0, len(counters))
		for name := range counters {
			names = append(names, name)
		}
		sort.Strings(names)

		var out strings.Builder
		for _, name := range names {
			fmt.Fprintf(&out, "# TYPE %s counter\n", name)
			keys := make([]string, 0, len(counters[name]))
			for key := range counters[name] {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			for _, key := range keys {
				fmt.Fprintf(&out, "%s%s %g\n", name, key, counters[name][key])
			}
		}
		metricsMu.Unlock()

		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		fmt.Fprint(w, out.String())
	}
}

// labelsKey renders a label set the way the exposition format wants it:
// sorted, quoted, and empty when there are no labels.
func labelsKey(labels map[string]string) string {
	if len(labels) == 0 {
		return ""
	}
	names := make([]string, 0, len(labels))
	for name := range labels {
		names = append(names, name)
	}
	sort.Strings(names)
	parts := make([]string, 0, len(names))
	for _, name := range names {
		parts = append(parts, fmt.Sprintf("%s=%q", name, labels[name]))
	}
	return "{" + strings.Join(parts, ",") + "}"
}
