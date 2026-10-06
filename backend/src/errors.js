// An error whose message is safe to show to the extension user.
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
