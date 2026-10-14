FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py core.py ./
USER 1000:1000
ENV HOST=0.0.0.0 PORT=18080 CONTEXT_GUARD_QQ_STATE=/state/qq.sqlite
CMD ["python", "app.py"]
