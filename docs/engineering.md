# Engineering principles

## Decide, then commit

Never make a lasting change you might have to undo because a check you haven't run yet could fail. Run the check
first; make the change only once the outcome is decided.

It's the same rule as testing code before `git push`: you don't push and then revert when the tests fail.

For the server, the lasting change is a **pin**. A pin tells Kubo to keep content permanently and to serve it to
anyone who asks. So:

- **Never pin something you might unpin because of a check that hasn't run yet.** The server fetches a pushed
  package's whole tree *without pinning*, checks it with Unilog, and pins only if it passes. A refused package
  was never pinned, so there is nothing to undo, and no chance that a failed undo leaves invalid content hosted.
- **Fetching is not keeping.** Fetched data is cached like anything a Kubo node downloads, until garbage
  collection. That's Kubo's normal behaviour; the server doesn't add work to fight it, except to collect garbage
  after a refusal, so its node stops serving what it refused.
- **What it keeps, it keeps for good.** The server never removes a package it accepted: removing requests isn't
  supported at all. It unpins only to undo a half-finished operation after an unexpected error from Kubo itself.

More generally: prefer the order of operations that needs no cleanup. Work with the tools' natural behaviour
(here, Kubo's) rather than doing something and then undoing it.
