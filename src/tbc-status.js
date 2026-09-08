// Official TBC status IDs, not browser redirect parameters.
const STATES = {
  0: ['redirected', 'awaiting_customer', false],
  1: ['verification_required', 'under_review', false],
  2: ['verification_required', 'awaiting_customer_contract', false],
  3: ['cancelled', 'expired', true],
  4: ['cancelled', 'cancelled', true],
  5: ['verification_required', 'awaiting_merchant_confirmation', false],
  6: ['declined', 'declined', true],
  7: ['cancelled', 'merchant_cancelled', true],
  8: ['approved', 'disbursed', true],
  9: ['verification_required', 'awaiting_disbursement', false],
  10: ['verification_required', 'awaiting_renewed_contract', false],
  11: ['verification_required', 'awaiting_income_documents', false],
  12: ['verification_required', 'reviewing_income_documents', false],
  13: ['verification_required', 'income_documents_declined', false]
};

export function mapTbcStatus(bankStatus) {
  if (!Number.isInteger(bankStatus) || !Object.hasOwn(STATES, bankStatus)) {
    const error = new Error('TBC returned an unknown application status');
    error.statusCode = 502;
    throw error;
  }
  const [status, stage, terminal] = STATES[bankStatus];
  return { status, stage, terminal };
}

export function tbcStatusFields(status, { now = new Date() } = {}) {
  const label = status === 'approved' ? 'დამტკიცებულია'
    : ['declined', 'cancelled', 'failed'].includes(status) ? 'უარყოფილია'
      : ['pending', 'redirected'].includes(status) ? 'მომხმარებელი ავსებს' : 'განხილვაშია';
  return {
    'განვადების ბანკი': 'თიბისი',
    'განვადების სტატუსი': label,
    'სტატუსის წყარო': 'ბანკი',
    'ბოლო სტატუსის განახლება': now.toISOString()
    // Preserve fulfillment status and manually reconciled payments/paid amount.
    // A bank decision is not a bank-account settlement notification.
  };
}
