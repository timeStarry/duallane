package files

import "github.com/jackc/pgx/v5"

// NewTransaction provides only the files domain's typed operations to a trusted
// aggregate transaction. It never gives an HTTP caller a database handle.
func (r *PGRepository) NewTransaction(tx pgx.Tx) Tx { return &pgTx{tx: tx, repository: r} }
func NewPGTransaction(tx pgx.Tx) Tx                 { return NewPGRepository(nil).NewTransaction(tx) }
