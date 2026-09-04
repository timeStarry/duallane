package config

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
)

const maximumS3CredentialsBytes int64 = 64 * 1024

type S3Credentials struct {
	AccessKey string
	SecretKey string
}

// LoadS3Credentials reads the existing Docker secret JSON contract without
// ever including its path or values in a returned error.
func LoadS3Credentials(path string) (S3Credentials, error) {
	if strings.TrimSpace(path) == "" {
		return S3Credentials{}, invalidS3CredentialsError()
	}
	file, err := os.Open(path)
	if err != nil {
		return S3Credentials{}, invalidS3CredentialsError()
	}
	defer file.Close()
	limited := io.LimitReader(file, maximumS3CredentialsBytes+1)
	data, err := io.ReadAll(limited)
	if err != nil || int64(len(data)) > maximumS3CredentialsBytes {
		return S3Credentials{}, invalidS3CredentialsError()
	}
	var value struct {
		AccessKey string `json:"accessKey"`
		SecretKey string `json:"secretKey"`
	}
	if err := json.Unmarshal(data, &value); err != nil {
		return S3Credentials{}, invalidS3CredentialsError()
	}
	value.AccessKey = strings.TrimSpace(value.AccessKey)
	value.SecretKey = strings.TrimSpace(value.SecretKey)
	if value.AccessKey == "" || value.SecretKey == "" {
		return S3Credentials{}, invalidS3CredentialsError()
	}
	return S3Credentials{AccessKey: value.AccessKey, SecretKey: value.SecretKey}, nil
}

func invalidS3CredentialsError() error {
	return errors.New("WORKSPACE_S3_CREDENTIALS_FILE cannot be read")
}
