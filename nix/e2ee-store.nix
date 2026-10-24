# Where e2ee-store (the backend, the SDK, the NixOS module) comes from: the one place it is pinned. The hash makes
# the pin usable from pure evaluation too (e.g. a host's flake).
#
# Everything else imports this file and only uses paths inside it. To work on e2ee-store at the same time, see
# the Makefile (BACKEND, SDK) for the development loop.
fetchTarball {
  url = "https://github.com/sashee/e2ee-store/archive/1e9ae8af0b9eaf895871451f5d51d0bbe1e35648.tar.gz";
  sha256 = "08gmbbrp7f5dr7ai7i5fif4qai7mfjrsjby8qk5nm7w762l2j7zv";
}
