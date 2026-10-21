# Security

Reachstack holds mailbox passwords, contacts and conversations, so security problems matter. Thank you for reporting
them responsibly.

## Reporting a problem

Please **don't open a public issue**. Use GitHub's private reporting instead: the **Security** tab of this repository →
**Report a vulnerability**. Describe what you found, how to reproduce it and what it lets someone do. You'll get an
answer as soon as possible, and credit when it's fixed, if you'd like.

If that button isn't there, open an issue that asks for a private contact, without any details.

## Keeping an installation safe

- On your own computer, Reachstack is reachable from that computer only, unless you start it with `--lan`.
- On a server, put it behind HTTPS (see [docs/self-hosting.md](docs/self-hosting.md)) and create the owner account
  straight away. After the first account, people need an invitation unless the owner opens sign-up.
- Keep the `data` folder and `.env` private: they hold the database and the key that encrypts saved passwords.
- Update when a new version comes out, and keep backups (Settings → Installation → Backups).
