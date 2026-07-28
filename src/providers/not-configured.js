export function notConfigured(bank) {
  return {
    async initiate() {
      const error = new Error(`${bank} integration is not configured. Add newly issued credentials and the current contract-specific request.`);
      error.statusCode = 503;
      throw error;
    },
    verifyWebhook() { return false; }
  };
}
