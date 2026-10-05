/** A release artifact that cannot be produced correctly. Packaging stops; nothing partial is published. */
export class PackagingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackagingError';
  }
}
