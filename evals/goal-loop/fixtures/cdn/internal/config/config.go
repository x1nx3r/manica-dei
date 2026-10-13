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
	MaxUploadMB    int64
	ServerPort     string

	S3Bucket    string
	S3Region    string
	S3AccessKey string
	S3SecretKey string
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
		MaxUploadMB:    maxMB,
		ServerPort:     getEnv("SERVER_PORT", "8080"),
		S3Bucket:       getEnv("S3_BUCKET", ""),
		S3Region:       getEnv("S3_REGION", ""),
		S3AccessKey:    getEnv("S3_ACCESS_KEY", ""),
		S3SecretKey:    getEnv("S3_SECRET_KEY", ""),
	}
}

func getEnv(key, fallback string) string {
	if val, ok := os.LookupEnv(key); ok {
		return val
	}
	return fallback
}
