\
# Run from the remote-agent directory in PowerShell.
# Create .env from .env.example first and set a long random AGENT_TOKEN.
.\venv\Scripts\python.exe -m waitress --listen=0.0.0.0:5051 agent:app
