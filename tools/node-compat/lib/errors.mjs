export class WorkspaceError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}
