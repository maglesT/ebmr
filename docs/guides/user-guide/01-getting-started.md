# Getting started

This page is for everyone. It explains the two installations, how to sign in at an office PC and at a shop-floor
kiosk, how an electronic signature works, and what to do when the system refuses something.

## Two installations: GMP and the sandbox

Batchwright runs as two separate installations.

- **GMP** holds the real batch records. What you do there is a GMP record, with your name, the time and, for a
  signature, its meaning.
- **The sandbox** is for test runs of master batch records and for training. Every sandbox screen carries the band
  **TEST, NOT GMP** and a watermark. Nothing in the sandbox is a GMP record, and the GMP installation never takes data
  from it.

The header shows which one you are on (GMP installation, or Sandbox (test runs)). If a page belongs to the other
installation, the screen says so and asks you to reload it.

## Signing in

The sign-in page shows **Batchwright Tablets** and **by Medhanta**, then the installation and the terminal.

| Where | How you sign in |
|---|---|
| Office PC | Your user ID and password. |
| Shop-floor kiosk | Tap your badge on the reader, then type your PIN on the keypad. The badge waits only a short time for its PIN; if you walk away, the screen asks for a badge again. |

On your first sign-in the system asks you to choose a new password or PIN. A PIN is typed key by key on the keypad;
it is never filled in by the browser or pasted.

If your account holds more than one role, you choose the role you work in now. Every entry and signature is recorded
under that role. If no role of yours is valid now (a grant still waiting for approval, expired or revoked), the screen
says so and names who can help: the system administrator.

## The header

The header shows the product (Batchwright Tablets, by Medhanta), the installation, your name, user ID and role, and the
terminal (and its room on the floor).

- **Lock** hides the screen until you sign in again. Use it when you step away.
- **Switch user** (kiosks) locks the screen for the next person. Anything you had open that was not signed is closed,
  and the next person signs with their own badge and PIN.
- **Sign out** ends your session.
- **Batchwright Tablets** (the product name) opens the **About** page (`/about`): the product, edition, version, maker
  and installation.

A session that is not used for a while is locked by the system; the screen then asks you to sign in again. Nothing
unsigned is kept for the next person.

## The home screen

The home screen (`/`) shows a tile for each part of the application your installation offers. A screen shows what
your role may see; the server checks every request again and refuses what your role may not do. The full list of
screens is in [Screens](../reference/screens.md).

## Electronic signatures

Many tasks end with an electronic signature. A signature always states a **meaning** (for example *Performed*,
*Verified*, *Quality-unit review*). The dialog shows:

1. the text you sign (what the record says now, read from the server),
2. the meaning of the signature,
3. your name, and the countdown in which you must confirm.

You confirm with your password (office) or your badge and PIN (kiosk). The signature is bound to the exact text you
saw: if the record changed meanwhile, the signature is refused and you sign the new text. After signing, the record
shows your name, the date and time, and the meaning.

Some acts need a second, independent person: the verifier of a weighing is never the person who weighed, and the
approver of an MBR is never its author. The system refuses the same person in both roles.

The meanings and the rights that may sign each are listed in
[Rights, roles and signature meanings](../reference/permissions.md#signature-meanings).

## When the system refuses something

A refusal always says, in plain words:

- **What happened** (for example "The entry is outside its limits. Nothing was recorded.").
- **Why** (the rule, and the control it comes from).
- **What you can do** next.
- **Who can help.**

Nothing is half-recorded: a refused act leaves no partial entry. If a refusal names a deviation, raise it on the
**Quality** screens (see [Operator and shift supervisor](02-operator-and-shift-supervisor.md#exceptions-and-deviations)).

## Corrections

You never overwrite a value. A correction is a new entry with a reason; the old value stays in the record and in the
audit trail. Some corrections also need an approval (signature meaning `CORRECTION_APPROVED`).
