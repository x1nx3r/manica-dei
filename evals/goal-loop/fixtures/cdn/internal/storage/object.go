package storage

import (
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/google/uuid"
)

// ObjectStorage stands in for a remote object store. It has the same shape as the
// local backend — same interface, same naming, same returned URL — but writes to
// its own directory rather than to the upload directory, so the service can be
// driven against a second backend with no network and no client library.
//
// A deployment points STORAGE_BACKEND at this when the box's disk is not where
// uploads should live.
type ObjectStorage struct {
	Dir     string
	BaseURL string
}

func NewObjectStorage(dir, baseURL string) *ObjectStorage {
	os.MkdirAll(dir, os.ModePerm)
	return &ObjectStorage{Dir: dir, BaseURL: baseURL}
}

func (o *ObjectStorage) SaveFile(file io.Reader, originalName string) (string, error) {
	ext := filepath.Ext(originalName)
	newName := uuid.New().String() + ext

	dst, err := os.Create(filepath.Join(o.Dir, newName))
	if err != nil {
		return "", err
	}
	defer dst.Close()

	if _, err := io.Copy(dst, file); err != nil {
		return "", err
	}

	return fmt.Sprintf("%s/files/%s", o.BaseURL, newName), nil
}
