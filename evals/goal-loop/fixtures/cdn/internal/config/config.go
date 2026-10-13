package config

import (
	"log"
	"os"
	"strconv"

	"github.com/joho/godotenv"
)

type Config struct {
	StorageBackend string
	UploadDir      string
	ObjectDir      string
	MaxUploadMB    int64
	ServerPort     string
}

func LoadConfig() *Config {
	_ = godotenv.Load() // Ignore error if no .env

	maxMB, err := strconv.ParseInt(getEnv("MAX_UPLOAD_MB", "10"), 10, 64)
	if err != nil {
		log.Fatal("Invalid MAX_UPLOAD_MB")
	}

	return &Config{
		StorageBackend: getEnv("STORAGE_BACKEND", "local"),
		UploadDir:      getEnv("UPLOAD_DIR", "./uploads"),
		ObjectDir:      getEnv("OBJECT_DIR", "./objects"),
		MaxUploadMB:    maxMB,
		ServerPort:     getEnv("SERVER_PORT", "8080"),
	}
}

func getEnv(key, fallback string) string {
	if val, ok := os.LookupEnv(key); ok {
		return val
	}
	return fallback
}
