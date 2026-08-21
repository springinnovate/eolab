#!/bin/sh
set -eu

# The host filesystem and Compose read_only setting are the primary controls.
# This startup guard is defense in depth: some deployment layers can report the
# bind as rw even when the kernel has inherited a read-only NFS mount. It checks
# the process's effective kernel mount mode and refuses to run if that mode ever
# becomes writable. It does not make a writable source safe or remount it.
if ! grep -Eq \
    '^[^ ]+ [^ ]+ [^ ]+ [^ ]+ /scan-source ro(,| )' \
    /proc/self/mountinfo; then
    echo >&2 "/scan-source is not effectively mounted read-only; refusing to start"
    echo >&2 "Configure the host filesystem as read-only and keep Compose read_only: true."
    exit 1
fi

exec "$@"
