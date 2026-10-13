package storage

import "io"

type Storage interface {
	SaveFile(file io.Reader, originalName string) (string, error)
}
