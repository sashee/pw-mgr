# Where e2ee-store (the backend, the SDK, the NixOS module) comes from: the one place it is pinned. The hash makes
# the pin usable from pure evaluation too (e.g. a host's flake).
#
# Everything else imports this file and only uses paths inside it. To work on e2ee-store at the same time, see
# the Makefile (BACKEND, SDK) for the development loop.
fetchTarball {
  url = "https://github.com/sashee/e2ee-store/archive/ef8e2b242c8a2bcae1c7b85ed5fcb792fef998b4.tar.gz";
  sha256 = "1k7ydbylnl295klkwnl4832r8h7gqmgl7kf4spl4isjrq5ycqaii";
}
