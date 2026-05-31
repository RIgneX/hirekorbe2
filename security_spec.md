# Security Specification

## Data Invariants
1. A session must belong to a valid user.
2. A user can only read and write their own profile and sessions.
3. Timestamps and ownership fields must be strictly validated.
4. Document IDs must be valid strings.

## The "Dirty Dozen" Payloads

1. **Identity Spoofing**: Attempt to create a session with a different `userId`.
2. **Resource Poisoning**: Use a 1MB string as a `sessionId`.
3. **Privilege Escalation**: Attempt to update a user profile's `userId`.
4. **Orphaned Sessions**: Create a session for a non-existent user.
5. **PII Leak**: A user attempts to read another user's profile.
6. **Time Warp**: Attempt to set a past or future `createdAt` timestamp (not using server timestamp).
7. **Schema Violation**: Create a session without a `result` object.
8. **Shadow Field**: Adding `isVerified: true` to a user profile.
9. **Update Gap**: Modifying `createdAt` field in an update.
10. **Cross-User Delete**: User A attempts to delete User B's session.
11. **Bulk Read**: User attempts to list all users in the system.
12. **Malicious Query**: Bypassing owner filter in a list query.

## The Test Runner (Mock)
Testing will be performed via rule logic verification.
