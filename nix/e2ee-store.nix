# Where e2ee-store (the backend, the SDK, the NixOS module) comes from: the one place it is pinned. The hash makes
# the pin usable from pure evaluation too (e.g. a host's flake).
#
# Everything else imports this file and only uses paths inside it. To work on e2ee-store at the same time, see
# the Makefile (BACKEND, SDK) for the development loop.
fetchTarball {
  url = "https://github.com/sashee/e2ee-store/archive/e411a35ac624da92c37f2551bafd23a3711b1469.tar.gz";
  sha256 = "15xbc5wz4j2nlaj9q9rkdslc8wq8svhb4xhhmz14qzjw3xarmpnq";
}
