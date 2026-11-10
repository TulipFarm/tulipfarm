FROM node:26-bookworm-slim
LABEL org.tulipfarm.execution.protocol="1"
RUN apt-get update \
    && apt-get install --no-install-recommends -y python3 python3-venv python3-pip git ca-certificates \
    && rm -rf /var/lib/apt/lists \
    && mkdir -p /work /run/execution /opt/execution
COPY supervisor.py /opt/execution/supervisor.py
RUN python3 -m py_compile /opt/execution/supervisor.py
ENTRYPOINT ["python3", "-I", "/opt/execution/supervisor.py"]
