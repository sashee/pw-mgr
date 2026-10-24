# Where e2ee-store (the backend, the SDK, the NixOS module) comes from: the one place it is pinned. The hash makes
# the pin usable from pure evaluation too (e.g. a host's flake).
#
# Everything else imports this file and only uses paths inside it. To work on e2ee-store at the same time, see
# the Makefile (BACKEND, SDK) for the development loop.
fetchTarball {
  url = "https://github.com/sashee/e2ee-store/archive/8d7617098da0718771293dabcda9eaeaae742323.tar.gz";
  sha256 = "1lrapkmagzdsqp4ii5x3y9p14q7b83pw1aiic3si5q05qc60azya";
}
