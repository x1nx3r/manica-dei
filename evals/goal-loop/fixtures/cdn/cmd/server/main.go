package main

import (
	"fmt"
	"net/http"

	"cdn-server/internal/config"
	"cdn-server/internal/handlers"
	"cdn-server/internal/storage"
)

func main() {
	cfg := config.LoadConfig()
	baseURL := fmt.Sprintf("http://localhost:%s", cfg.ServerPort)

	var store storage.Storage
	if cfg.StorageBackend == "s3" {
		store = storage.NewS3Storage(cfg.S3Bucket, cfg.S3Region, cfg.S3AccessKey, cfg.S3SecretKey, baseURL)
	} else {
		store = storage.NewLocalStorage(cfg.UploadDir, baseURL)
	}

	http.Handle("/metrics", handlers.MetricsHandler())
	http.HandleFunc("/upload", handlers.UploadHandler(cfg, store))
	http.Handle("/files/", http.StripPrefix("/files/", handlers.FileServer(cfg.UploadDir)))

	fmt.Println("Server running at", baseURL)
	if err := http.ListenAndServe(":"+cfg.ServerPort, nil); err != nil {
		panic(err)
	}
}
