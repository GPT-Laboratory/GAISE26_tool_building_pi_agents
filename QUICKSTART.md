wo ways to try it locally                                
                            
  Option A — Container only (fastest, no backend)
                                                                                                                           
  Tests just the Docker image. Opens ttyd directly in the browser.                                                         
  # Build once                                                                                                             
  docker build -t pi-workshop -f docker/Dockerfile .                                                                       
                                                                                                                           
  # Run (ports published to localhost only)
  OPENAI_API_KEY=sk-... PI_MODEL=gpt-4o-mini ./scripts/run-one.sh                                                          
  # → open http://localhost:7681 (agent) and http://localhost:7682 (work)
                                                                                                                           
  Option B — Full stack, one container (tests the join flow + UI)                                                          
                                                                                                                           
  cp backend/.env.example .env                                                                                             
  # edit .env: set PI_MODEL, OPENAI_API_KEY, OPENAI_BASE_URL                                                               
                                                                                                                           
  docker build -t pi-workshop -f docker/Dockerfile .   # workshop image (once)                                             
  docker compose up                                     # starts backend with POOL_SIZE=1                                  
  # → open http://localhost:3000                            
  docker-compose.yml hard-sets POOL_SIZE=1 so only one container starts. frontend/ is bind-mounted so you can edit
  index.html without rebuilding.                                                                                           
                                
  With a local model (Ollama, LM Studio, etc.)                                                                             
                                                                                                                           
  OPENAI_BASE_URL=http://host.docker.internal:11434/v1
  OPENAI_API_KEY=ollama                                                                                                    
  PI_MODEL=llama3.2
