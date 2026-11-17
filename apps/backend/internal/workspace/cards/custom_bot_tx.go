package cards

import "context"

// UpdateCustomBotCardInTx preserves the card domain's revision, ownership,
// event and audit rules inside a trusted aggregate task transaction.
func (s *Service) UpdateCustomBotCardInTx(ctx context.Context, tx Tx, input CustomBotUpdateInput) (*Card, error) {
	if tx == nil {
		return nil, NewError(CodeInternal, "卡片事务未就绪", 500)
	}
	return s.updateCustomBot(ctx, input, tx)
}
