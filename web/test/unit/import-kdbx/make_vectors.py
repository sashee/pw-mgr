import hashlib, json
from argon2.low_level import hash_secret_raw, Type
from Crypto.Cipher import ChaCha20, Salsa20, AES

v = {}
v["blake2b"] = [
    {"input": "", "outlen": 64, "hex": hashlib.blake2b(b"", digest_size=64).hexdigest()},
    {"input": "abc", "outlen": 64, "hex": hashlib.blake2b(b"abc", digest_size=64).hexdigest()},
    {"input": "abc", "outlen": 32, "hex": hashlib.blake2b(b"abc", digest_size=32).hexdigest()},
    {"input": "x" * 300, "outlen": 64, "hex": hashlib.blake2b(b"x" * 300, digest_size=64).hexdigest()},
    {"input": "y" * 128, "outlen": 17, "hex": hashlib.blake2b(b"y" * 128, digest_size=17).hexdigest()},
]
v["argon2"] = []
for name, t in [("d", Type.D), ("i", Type.I), ("id", Type.ID)]:
    for (tc, m, p, outlen) in [(3, 32, 4, 32), (2, 256, 2, 32), (1, 64, 1, 64), (2, 100, 3, 100)]:
        pwd, salt = b"password-\x01\xff", b"somesalt12345678"
        v["argon2"].append({"type": name, "t": tc, "m_kib": m, "p": p, "outlen": outlen, "password": pwd.hex(), "salt": salt.hex(),
            "hex": hash_secret_raw(pwd, salt, time_cost=tc, memory_cost=m, parallelism=p, hash_len=outlen, type=t, version=19).hex()})
key = bytes(range(32))
nonce12 = bytes.fromhex("000000000000004a00000000")
msg = b"Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it."
c = ChaCha20.new(key=key, nonce=nonce12); c.seek(64)  # counter 1, as in RFC 8439 2.4.2
v["chacha20"] = [{"key": key.hex(), "nonce": nonce12.hex(), "counter": 1, "plaintext": msg.hex(), "hex": c.encrypt(msg).hex()}]
c = ChaCha20.new(key=bytes([7]) * 32, nonce=bytes([9]) * 12)
v["chacha20"].append({"key": (bytes([7]) * 32).hex(), "nonce": (bytes([9]) * 12).hex(), "counter": 0, "plaintext": (b"\0" * 300).hex(), "hex": c.encrypt(b"\0" * 300).hex()})
skey = hashlib.sha256(b"protected stream key").digest()
iv = bytes.fromhex("e830094b97205d2a")
s = Salsa20.new(key=skey, nonce=iv)
v["salsa20"] = [{"key": skey.hex(), "nonce": iv.hex(), "plaintext": (b"\0" * 200).hex(), "hex": s.encrypt(b"\0" * 200).hex()}]
# AES-KDF: R rounds of AES-256-ECB on each 16-byte half, then SHA-256.
seed, comp = bytes(range(100, 132)), hashlib.sha256(b"composite").digest()
for rounds in [1, 100, 6000]:
    e = AES.new(seed, AES.MODE_ECB); x = comp
    for _ in range(rounds): x = e.encrypt(x)
    v.setdefault("aeskdf", []).append({"seed": seed.hex(), "key": comp.hex(), "rounds": rounds, "hex": hashlib.sha256(x).hexdigest()})
print(json.dumps(v, indent=1))
