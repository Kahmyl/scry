#!/bin/sh
set -eu
restic --retry-lock 10m backup /artifacts --host scry-production --tag artifacts --tag veil-evidence
