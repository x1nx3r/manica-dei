package storage

import "io"

type S3Storage struct {
	Bucket string
	Region string
	// creds, etc.
}

func NewS3Storage(bucket, region, accessKey, secretKey, baseURL string) *S3Storage {
	return &S3Storage{Bucket: bucket, Region: region}
}

func (s *S3Storage) SaveFile(file io.Reader, originalName string) (string, error) {
	// TODO: S3 upload
	return "", nil
}
