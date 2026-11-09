package server

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

type queryer interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

// Queries retains the first failure, skips later SQL, and prevents a failed unit
// of work from committing. Domain functions share it across permission checks.
type Queries struct {
	ctx context.Context
	db  queryer
	err error
}

func (q *Queries) Err() error { return q.err }
func (q *Queries) Check(err error) bool {
	if q.err == nil && err != nil {
		q.err = err
	}
	return q.err == nil
}
func (q *Queries) Require(ok bool, status int, message string) bool {
	if q.err != nil {
		return false
	}
	if !ok {
		q.err = &HTTPError{Status: status, Message: message}
		return false
	}
	return true
}
func (q *Queries) Exec(sql string, args ...any) int64 {
	if q.err != nil {
		return 0
	}
	tag, err := q.db.Exec(q.ctx, sql, args...)
	q.Check(err)
	return tag.RowsAffected()
}
func (q *Queries) Rows(sql string, args ...any) []Object {
	result := []Object{}
	if q.err != nil {
		return result
	}
	rows, err := q.db.Query(q.ctx, sql, args...)
	if !q.Check(err) {
		return result
	}
	defer rows.Close()
	columns := rows.FieldDescriptions()
	for rows.Next() {
		v, err := rows.Values()
		if !q.Check(err) {
			return result
		}
		row := Object{}
		for i, col := range columns {
			row[col.Name] = dbValue(v[i])
		}
		result = append(result, row)
	}
	q.Check(rows.Err())
	return result
}
func (q *Queries) One(sql string, args ...any) Object {
	rows := q.Rows(sql, args...)
	if len(rows) == 0 {
		return nil
	}
	return rows[0]
}
func dbValue(v any) any {
	switch x := v.(type) {
	case [16]byte:
		return fmt.Sprintf("%x-%x-%x-%x-%x", x[:4], x[4:6], x[6:8], x[8:10], x[10:])
	case pgtype.UUID:
		if !x.Valid {
			return nil
		}
		return dbValue(x.Bytes)
	case time.Time:
		return x.UTC().Format("2006-01-02T15:04:05.000Z")
	case []any:
		r := make([]any, len(x))
		for i, v := range x {
			r[i] = dbValue(v)
		}
		return r
	case map[string]any:
		r := Object{}
		for k, v := range x {
			r[k] = dbValue(v)
		}
		return r
	default:
		return v
	}
}

type Store struct {
	Pool     *pgxpool.Pool
	Blobs    BlobStore
	Resolver MemoryResolver
}

func Open(ctx context.Context, url, root string) (*Store, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, err
	}
	cfg.MaxConns = 10
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	return &Store{Pool: pool, Blobs: &Blobs{Root: root}, Resolver: &JevResolver{}}, nil
}
func (s *Store) read(ctx context.Context, fn func(*Queries) any) (any, error) {
	q := &Queries{ctx: ctx, db: s.Pool}
	result := fn(q)
	return result, q.err
}
func (s *Store) transaction(ctx context.Context, fn func(*Queries) any) (any, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() {
		rollbackCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(rollbackCtx)
	}()
	q := &Queries{ctx: ctx, db: tx}
	result := fn(q)
	if q.err != nil {
		return nil, q.err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return result, nil
}
