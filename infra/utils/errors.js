class AppError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
  }
}

class ValidationError extends AppError {
  constructor(message) {
    super(message, 400);
  }
}

class ScanError extends AppError {
  constructor(message) {
    super(message, 502);
  }
}

module.exports = { AppError, ValidationError, ScanError };
