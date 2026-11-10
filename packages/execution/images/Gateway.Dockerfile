FROM python:3.11-slim-bookworm
LABEL org.tulipfarm.execution.protocol="1"
RUN apt-get update \
    && apt-get install --no-install-recommends -y iptables \
    && rm -rf /var/lib/apt/lists
COPY firewall.py /opt/execution/firewall.py
RUN python3 -m py_compile /opt/execution/firewall.py
ENTRYPOINT ["python3", "-I", "/opt/execution/firewall.py"]
