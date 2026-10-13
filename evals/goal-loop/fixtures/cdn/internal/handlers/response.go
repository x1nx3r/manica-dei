package handlers

import (
	"encoding/json"
	"net/http"
)

type UploadResponse struct {
	URL      string `json:"url,omitempty"`
	Filename string `json:"filename,omitempty"`
	Status   string `json:"status"`
	Error    string `json:"error,omitempty"`
	Message  string `json:"message,omitempty"`
}

func WriteJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(payload)
}
