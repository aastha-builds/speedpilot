# WordPress agent skills

Install the official WordPress agent skills here (KICKOFF.md one-time setup, step 4):

```
git clone https://github.com/WordPress/agent-skills.git ../agent-skills
cd ../agent-skills
node shared/scripts/skillpack-build.mjs --clean
node shared/scripts/skillpack-install.mjs --dest=../speedpilot --targets=claude
```
