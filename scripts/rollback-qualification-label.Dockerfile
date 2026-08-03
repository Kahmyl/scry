ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG RELEASE_ID
ARG SCHEMA_FINGERPRINT
LABEL org.scry.release-id=${RELEASE_ID} \
      org.scry.schema-fingerprint=${SCHEMA_FINGERPRINT} \
      org.scry.privacy-authority=veil-only
