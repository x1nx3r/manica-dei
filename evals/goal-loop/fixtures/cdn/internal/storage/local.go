package storage

import (
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/google/uuid"
)

type LocalStorage struct {
	UploadDir string
	BaseURL   string
}

func NewLocalStorage(uploadDir, baseURL string) *LocalStorage {
	os.MkdirAll(uploadDir, os.ModePerm)
	return &LocalStorage{UploadDir: uploadDir, BaseURL: baseURL}
}

func (l *LocalStorage) SaveFile(file io.Reader, originalName string) (string, error) {
	ext := filepath.Ext(originalName)
	newName := uuid.New().String() + ext
	dstPath := filepath.Join(l.UploadDir, newName)

	dst, err := os.Create(dstPath)
	if err != nil {
		return "", err
	}
	defer dst.Close()

	if _, err := io.Copy(dst, file); err != nil {
		return "", err
	}

	return fmt.Sprintf("%s/files/%s", l.BaseURL, newName), nil
}
