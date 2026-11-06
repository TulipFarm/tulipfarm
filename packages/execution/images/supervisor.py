import argparse
import base64
import hashlib
import json
import os
import selectors
import signal
import socket
import stat
import struct
import subprocess
import time
import uuid


SOCKET = "/run/execution/control"
PACKET = 1024 * 1024
BLOCK = 64 * 1024
OUTPUT_BLOCK = 8 * 1024
UID = 1000


def deadline_watchdog(allocation_deadline):
    reader, writer = os.pipe2(os.O_CLOEXEC | os.O_NONBLOCK)
    child = os.fork()
    if child == 0:
        os.close(writer)
        deadline = allocation_deadline
        while True:
            try:
                update = os.read(reader, 8)
                if not update:
                    os.kill(1, signal.SIGUSR1)
                    os._exit(0)
                deadline = min(allocation_deadline, struct.unpack("!d", update)[0])
            except BlockingIOError:
                pass
            if time.time() >= deadline:
                os.kill(1, signal.SIGUSR1)
                os._exit(0)
            time.sleep(0.02)
    os.close(reader)
    return writer


def receive(connection):
    data = bytearray()
    while not data.endswith(b"\n"):
        part = connection.recv(min(BLOCK, PACKET + 1 - len(data)))
        if not part or len(data) + len(part) > PACKET:
            raise ValueError("invalid-request")
        data.extend(part)
    return json.loads(data)


def send(connection, value):
    packet = json.dumps(value, separators=(",", ":")).encode() + b"\n"
    if len(packet) > PACKET:
        raise ValueError("response-limit")
    connection.sendall(packet)


def path_parts(value):
    if not isinstance(value, str) or not value or len(value) > 4096:
        raise ValueError("invalid-path")
    if any(ord(c) < 32 or ord(c) == 127 or c in "\\:" for c in value):
        raise ValueError("invalid-path")
    parts = value.split("/")
    if any(part in ("", ".", "..") for part in parts) or parts[0] == ".tf-control":
        raise ValueError("invalid-path")
    return parts


def open_file(value, flags=os.O_RDONLY):
    parts = path_parts(value)
    directory = os.open("/work", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        result = os.open(parts[-1], flags | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        metadata = os.fstat(result)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != UID:
            os.close(result)
            raise ValueError("invalid-file")
        return result
    finally:
        os.close(directory)


class Supervisor:
    def __init__(self, deadline, output_limit):
        self.deadline = deadline
        self.output_limit = output_limit
        self.selector = selectors.DefaultSelector()
        self.job = None
        self.process = None
        self.started = set()
        self.events = []
        self.output_bytes = 0
        self.output_truncated = False
        self.sequence = 0
        self.last_activity = time.monotonic()
        self.root = os.open("/work", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        self.watchdog = deadline_watchdog(deadline)
        self.upload = None
        self.staging = os.open("/work/.tf-control", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)

    def status(self):
        if self.job is None:
            return {"state": "absent"}
        return {key: value for key, value in self.job.items() if key not in ("deadline", "requestHash")}

    def output_event(self, kind, **fields):
        self.sequence += 1
        self.events.append({"sequence": self.sequence, "kind": kind, **fields})

    def collect(self):
        for key, _ in self.selector.select(timeout=0):
            data = os.read(key.fd, OUTPUT_BLOCK)
            if not data:
                self.selector.unregister(key.fileobj)
                key.fileobj.close()
                continue
            remaining = max(0, self.output_limit - self.output_bytes)
            kept = data[:remaining]
            self.output_bytes += len(kept)
            if kept:
                self.output_event("chunk", stream=key.data, data=base64.b64encode(kept).decode())
            if len(data) > remaining and not self.output_truncated:
                self.output_truncated = True
                self.output_event("truncated")
        if (
            self.process is not None and self.process.poll() is not None
            and not self.selector.get_map() and self.job["state"] == "running"
        ):
            self.output_event("end")
            self.job.update(state="completed", exitCode=self.process.returncode)
            print(json.dumps(self.status()), flush=True)
            os.write(self.watchdog, struct.pack("!d", self.deadline))
            self.last_activity = time.monotonic()

    def start(self, request):
        job_id = str(uuid.UUID(request["jobId"]))
        request_hash = hashlib.sha256(json.dumps(
            {"command": request["command"], "deadline": request["deadline"]}, sort_keys=True
        ).encode()).hexdigest()
        if self.job is not None and self.job["jobId"] == job_id:
            if self.job["requestHash"] != request_hash:
                raise ValueError("request-conflict")
            return self.status()
        if job_id in self.started:
            raise ValueError("outcome-unknown")
        if len(self.started) >= 64:
            raise ValueError("capacity")
        if self.job is not None and self.job["state"] == "running":
            raise ValueError("busy")
        deadline = request["deadline"]
        if not isinstance(deadline, (int, float)) or not time.time() < deadline <= self.deadline:
            raise ValueError("invalid-deadline")
        command = request["command"]
        program, args = command["program"], command["args"]
        if not isinstance(program, str) or not program or "\0" in program or len(program) > 4096:
            raise ValueError("invalid-command")
        if not isinstance(args, list) or len(args) > 256 or any(
            not isinstance(arg, str) or len(arg) > 65536 or "\0" in arg for arg in args
        ):
            raise ValueError("invalid-command")
        cwd = "/work"
        if command.get("cwd") is not None:
            # The workload's cwd is opened without following guest-controlled symlinks.
            directory = os.dup(self.root)
            try:
                for part in path_parts(command["cwd"]):
                    child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                    os.close(directory)
                    directory = child
                cwd = f"/proc/self/fd/{directory}"
                self.launch(job_id, deadline, program, args, cwd, (directory,), request_hash)
            finally:
                os.close(directory)
        else:
            self.launch(job_id, deadline, program, args, cwd, (), request_hash)
        return self.status()

    def launch(self, job_id, deadline, program, args, cwd, descriptors, request_hash):
        for key in list(self.selector.get_map().values()):
            self.selector.unregister(key.fileobj)
            key.fileobj.close()
        self.events = []
        self.sequence = 0
        self.output_bytes = 0
        self.output_truncated = False
        self.started.add(job_id)
        self.job = {"jobId": job_id, "state": "running", "deadline": deadline, "requestHash": request_hash}
        print(json.dumps(self.status()), flush=True)
        os.write(self.watchdog, struct.pack("!d", deadline))
        self.last_activity = time.monotonic()
        try:
            self.process = subprocess.Popen(
                [program, *args],
                cwd=cwd,
                env={"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/work/.home", "TMPDIR": "/work/.tmp", "LANG": "C.UTF-8"},
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                user=UID, group=UID, extra_groups=[], start_new_session=True, pass_fds=descriptors,
            )
        except OSError:
            self.output_event("end")
            self.job.update(state="completed", exitCode=127)
            print(json.dumps(self.status()), flush=True)
            os.write(self.watchdog, struct.pack("!d", self.deadline))
            self.process = None
            return
        for stream, label in ((self.process.stdout, "stdout"), (self.process.stderr, "stderr")):
            os.set_blocking(stream.fileno(), False)
            self.selector.register(stream, selectors.EVENT_READ, label)

    def request(self, request):
        operation = request["operation"]
        if operation == "status":
            return self.status()
        if operation == "start":
            return self.start(request)
        if operation == "output":
            after = request.get("after", 0)
            if not isinstance(after, int) or not 0 <= after <= self.sequence:
                raise ValueError("invalid-cursor")
            maximum = request["maximumBytes"]
            if not isinstance(maximum, int) or maximum <= 0:
                raise ValueError("invalid-limit")
            events = []
            used = 0
            for event in self.events[after:after + 64]:
                size = len(base64.b64decode(event["data"])) if event["kind"] == "chunk" else 0
                if used + size > maximum:
                    if not events:
                        raise ValueError("output-limit")
                    break
                events.append(event)
                used += size
            return {"events": events}
        if operation == "read":
            offset = request.get("offset", 0)
            if not isinstance(offset, int) or offset < 0:
                raise ValueError("invalid-offset")
            fd = open_file(request["path"])
            try:
                metadata = os.fstat(fd)
                if metadata.st_size != request["size"]:
                    raise ValueError("file-changed")
                return {"bytes": base64.b64encode(os.pread(fd, BLOCK, offset)).decode()}
            finally:
                os.close(fd)
        if operation == "file":
            fd = open_file(request["path"])
            try:
                metadata = os.fstat(fd)
                digest = hashlib.sha256()
                while True:
                    data = os.read(fd, BLOCK)
                    if not data:
                        break
                    digest.update(data)
                return {"path": request["path"], "size": metadata.st_size, "sha256": digest.hexdigest(),
                        "executable": bool(metadata.st_mode & stat.S_IXUSR)}
            finally:
                os.close(fd)
        if operation == "list":
            after = request.get("after", "")
            if not isinstance(after, str):
                raise ValueError("invalid-cursor")
            entries = []
            for parent, directories, files, directory in os.fwalk("/work", follow_symlinks=False):
                directories[:] = sorted(name for name in directories if parent != "/work" or name != ".tf-control")
                for name in sorted(files):
                    relative = os.path.relpath(os.path.join(parent, name), "/work")
                    relative.encode("utf-8", errors="strict")
                    path_parts(relative)
                    metadata = os.stat(name, dir_fd=directory, follow_symlinks=False)
                    if not stat.S_ISREG(metadata.st_mode):
                        continue
                    if relative > after:
                        entries.append(relative)
                        entries.sort()
                        if len(entries) > 100:
                            entries.pop()
            return {"files": [self.request({"operation": "file", "path": path}) for path in entries]}
        if operation == "write-begin":
            if self.upload is not None or (self.job is not None and self.job["state"] == "running"):
                raise ValueError("busy")
            parts = path_parts(request["path"])
            size = request["size"]
            digest = request["sha256"]
            if not isinstance(size, int) or size < 0 or not isinstance(digest, str) or len(digest) != 64:
                raise ValueError("invalid-file")
            if any(char not in "0123456789abcdef" for char in digest):
                raise ValueError("invalid-file")
            parent = os.dup(self.root)
            try:
                for part in parts[:-1]:
                    try:
                        os.mkdir(part, mode=0o755, dir_fd=parent)
                        os.chown(part, UID, UID, dir_fd=parent, follow_symlinks=False)
                    except FileExistsError:
                        pass
                    child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                    os.close(parent)
                    parent = child
                upload_id = uuid.uuid4().hex
                fd = os.open(upload_id, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.staging)
                self.upload = {"id": upload_id, "fd": fd, "parent": parent, "name": parts[-1],
                               "size": size, "sha256": digest, "executable": request.get("executable") is True,
                               "written": 0, "hash": hashlib.sha256()}
                parent = None
                return {"id": upload_id}
            finally:
                if parent is not None:
                    os.close(parent)
        if operation in ("write", "write-commit", "write-abort"):
            upload = self.upload
            if upload is None or upload["id"] != request["id"]:
                raise ValueError("invalid-upload")
            if operation == "write":
                data = base64.b64decode(request["bytes"], validate=True)
                if len(data) > BLOCK or len(data) > upload["size"] - upload["written"]:
                    raise ValueError("file-limit")
                offset = 0
                while offset < len(data):
                    offset += os.write(upload["fd"], data[offset:])
                upload["hash"].update(data)
                upload["written"] += len(data)
                return {"written": upload["written"]}
            try:
                if operation == "write-commit":
                    if upload["written"] != upload["size"] or upload["hash"].hexdigest() != upload["sha256"]:
                        raise ValueError("file-changed")
                    os.fchmod(upload["fd"], 0o755 if upload["executable"] else 0o644)
                    os.fchown(upload["fd"], UID, UID)
                    os.fsync(upload["fd"])
                    os.rename(upload["id"], upload["name"], src_dir_fd=self.staging, dst_dir_fd=upload["parent"])
                    os.fsync(upload["parent"])
                return {"state": "ready" if operation == "write-commit" else "aborted"}
            finally:
                os.close(upload["fd"])
                os.close(upload["parent"])
                try:
                    os.unlink(upload["id"], dir_fd=self.staging)
                except FileNotFoundError:
                    pass
                self.upload = None
        if operation == "remove":
            if self.job is not None and self.job["state"] == "running":
                raise ValueError("busy")
            parts = path_parts(request["path"])
            parent = os.dup(self.root)
            try:
                for part in parts[:-1]:
                    child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                    os.close(parent)
                    parent = child
                os.unlink(parts[-1], dir_fd=parent)
            finally:
                os.close(parent)
            return {"state": "removed"}
        raise ValueError("invalid-operation")

    def run(self):
        listener = socket.socket(socket.AF_UNIX)
        listener.bind(SOCKET)
        os.chmod(SOCKET, 0o600)
        listener.listen(4)
        listener.settimeout(0.02)
        while True:
            self.collect()
            now = time.time()
            if now >= self.deadline:
                os._exit(124)
            if self.job is not None and self.job["state"] == "running" and now >= self.job["deadline"]:
                os._exit(124)
            if (self.job is None or self.job["state"] != "running") and time.monotonic() - self.last_activity >= 300:
                os._exit(0)
            try:
                connection, _ = listener.accept()
            except TimeoutError:
                continue
            with connection:
                connection.settimeout(1)
                try:
                    send(connection, self.request(receive(connection)))
                except (ValueError, KeyError, TypeError, OSError):
                    try:
                        send(connection, {"error": "execution-request-failed"})
                    except OSError:
                        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("serve", "request"))
    parser.add_argument("--deadline", type=float)
    parser.add_argument("--output-limit", type=int)
    args = parser.parse_args()
    if args.mode == "request":
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(5)
            connection.connect(SOCKET)
            data = os.fdopen(0, "rb", closefd=False).read(PACKET + 1)
            if len(data) > PACKET:
                raise ValueError("invalid-request")
            send(connection, json.loads(data))
            print(json.dumps(receive(connection)))
        return
    if os.getpid() != 1 or os.getuid() != 0:
        raise RuntimeError("Supervisor requires its own container PID namespace")
    if args.deadline is None or not time.time() < args.deadline or args.output_limit is None or not 0 < args.output_limit <= PACKET // 8:
        raise ValueError("invalid-policy")
    os.chmod("/run/execution", 0o700)
    os.chmod("/work", 0o1777)
    os.mkdir("/work/.tf-control", mode=0o700)
    for path in ("/work/.home", "/work/.tmp"):
        os.mkdir(path, mode=0o700)
        os.chown(path, UID, UID)
    signal.signal(signal.SIGTERM, lambda *_: os._exit(0))
    signal.signal(signal.SIGUSR1, lambda *_: os._exit(124))
    supervisor = Supervisor(args.deadline, args.output_limit)

    def stop(state, code):
        if supervisor.job is not None and supervisor.job["state"] == "running":
            supervisor.job["state"] = state
            print(json.dumps(supervisor.status()), flush=True)
        os._exit(code)

    signal.signal(signal.SIGTERM, lambda *_: stop("cancelled", 0))
    signal.signal(signal.SIGUSR1, lambda *_: stop("timed-out", 124))
    supervisor.run()


if __name__ == "__main__":
    main()
