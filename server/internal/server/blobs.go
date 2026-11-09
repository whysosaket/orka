package server

import (
	"errors"
	"os"
	"path/filepath"
)

type Blobs struct{ Root string }
type BlobStore interface {
	Read(string, string) ([]byte, error)
	Put(string, []byte) (string, error)
	RemoveProject(string) error
}

func (b *Blobs) path(project, hash string) (string, error) {
	if !validUUID(project) || !validDigest(hash) {
		return "", bad("Invalid blob identity")
	}
	return filepath.Join(b.Root, project, hash), nil
}
func (b *Blobs) Read(project, hash string) ([]byte, error) {
	path, err := b.path(project, hash)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if bytesHash(data) != hash {
		return nil, errors.New("blob integrity failure")
	}
	return data, nil
}
func (b *Blobs) Put(project string, data []byte) (string, error) {
	hash := bytesHash(data)
	path, err := b.path(project, hash)
	if err != nil {
		return "", err
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return "", err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".staged-")
	if err != nil {
		return "", err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(data); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return "", err
	}
	if closeErr != nil {
		return "", closeErr
	}
	if err = os.Rename(f.Name(), path); err != nil {
		return "", err
	}
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return "", err
	}
	defer dir.Close()
	if err = dir.Sync(); err != nil {
		return "", err
	}
	return hash, nil
}
func (b *Blobs) RemoveProject(project string) error {
	if !validUUID(project) {
		return bad("Invalid project identity")
	}
	return os.RemoveAll(filepath.Join(b.Root, project))
}
func (s *Store) readBlob(q *Queries, project, hash string) []byte {
	if q.err != nil {
		return nil
	}
	v, err := s.Blobs.Read(project, hash)
	q.Check(err)
	return v
}
func (s *Store) putBlob(q *Queries, project string, bytes []byte) string {
	if q.err != nil {
		return ""
	}
	hash, err := s.Blobs.Put(project, bytes)
	q.Check(err)
	return hash
}
