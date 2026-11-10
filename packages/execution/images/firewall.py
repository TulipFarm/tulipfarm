import argparse
import ipaddress
import signal
import subprocess
import sys


PRIVATE_NETWORKS = (
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
    "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24",
    "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24",
    "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
)


def rule(binary, *arguments):
    subprocess.run([binary, "--wait", "2", *arguments], check=True, stdout=subprocess.DEVNULL)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--lifetime-seconds", required=True, type=int)
    parser.add_argument("--deny-network", action="append", default=[])
    args = parser.parse_args()
    if not 0 < args.lifetime_seconds <= 86400:
        raise ValueError("invalid-lifetime")
    networks = [ipaddress.ip_network(value) for value in (*PRIVATE_NETWORKS, *args.deny_network)]
    for binary in ("iptables", "ip6tables"):
        for chain in ("INPUT", "OUTPUT", "FORWARD"):
            rule(binary, "-P", chain, "DROP")
        rule(binary, "-A", "OUTPUT", "-o", "lo", "-j", "ACCEPT")
        rule(binary, "-A", "INPUT", "-i", "lo", "-j", "ACCEPT")
        rule(binary, "-A", "INPUT", "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT")
    for network in networks:
        binary = "iptables" if network.version == 4 else "ip6tables"
        rule(binary, "-A", "OUTPUT", "-d", str(network), "-j", "REJECT")
    rule("iptables", "-A", "OUTPUT", "-j", "ACCEPT")
    # IPv6 remains closed except for the guest's own loopback until separately qualified.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    signal.signal(signal.SIGALRM, lambda *_: sys.exit(0))
    signal.alarm(args.lifetime_seconds)
    print("ready", flush=True)
    while True:
        signal.pause()


if __name__ == "__main__":
    main()
