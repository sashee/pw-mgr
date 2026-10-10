# Where e2ee-store (the backend, the SDK, the NixOS module) comes from: the one place it is pinned. The hash makes
# the pin usable from pure evaluation too (e.g. a host's flake).
#
# Everything else imports this file and only uses paths inside it. To work on e2ee-store at the same time, see
# the Makefile (BACKEND, SDK) for the development loop.
fetchTarball {
  url = "https://github.com/sashee/e2ee-store/archive/c69c79b86e82e44a87041d03b3dd4661db5be0bc.tar.gz";
  sha256 = "005h1hw3fd0liylirmxaq6d5chvc7yyzzkkj1pscijdidkz0hw8z";
}
