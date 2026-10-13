package handlers

import (
	"net/http"
	"strings"
)

func FileServer(uploadDir string) http.Handler {
	fs := http.FileServer(http.Dir(uploadDir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		if !strings.HasSuffix(r.URL.Path, "/") {
			fs.ServeHTTP(w, r)
			return
		}
		// Use WriteJSON for a 404
		WriteJSON(w, http.StatusNotFound, UploadResponse{
			Status:  "error",
			Error:   "not_found",
			Message: "File not found",
		})
	})
}
