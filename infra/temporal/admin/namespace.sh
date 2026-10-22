#!/bin/sh
# Wait for the Temporal frontend, then create $NAMESPACE if it does not exist.
set -eu
until temporal operator cluster health; do sleep 5; done
temporal operator namespace describe -n "$NAMESPACE" ||
  temporal operator namespace create -n "$NAMESPACE" --retention "$RETENTION"
