package storage

import (
	"io"
	"net/http"
)

var AllowedMIME = map[string]bool{
	"image/jpeg": true,
	"image/png":  true,
	"image/gif":  true,
	"image/webp": true,
	"audio/mpeg": true,
	"audio/wav":  true,
	"audio/ogg":  true,
}

// CheckFileType reads the first 512 bytes of the file to infer its MIME type.
// It returns the MIME type string and resets the file pointer to the beginning.
func CheckFileType(file io.ReadSeeker) (string, error) {
	// Create a buffer (slice of bytes) to hold up to 512 bytes from the file.
	buf := make([]byte, 512)

	// Read up to 512 bytes from the file into the buffer.
	// n is the number of bytes actually read.
	n, err := file.Read(buf)
	// If there was an error (other than reaching end of file), return the error.
	if err != nil && err != io.EOF {
		return "", err
	}

	// Detect the MIME type using only the bytes that were actually read.
	// buf[:n] means "the first n bytes of buf".
	mimeType := http.DetectContentType(buf[:n])

	// Reset the file pointer to the beginning so the file can be read again.
	_, err = file.Seek(0, io.SeekStart)
	if err != nil {
		return "", err
	}

	// Return the detected MIME type and nil error.
	return mimeType, nil
}
