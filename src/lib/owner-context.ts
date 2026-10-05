interface OwnerContext {
  locals: Record<string, unknown>;
}

// Owner handlers run after authentication has populated the request's user.
export function ownerUsername(response: OwnerContext): string {
  const username = response.locals.username;
  if (typeof username !== "string") {
    throw new Error("Owner route requires an authenticated user.");
  }
  return username;
}
