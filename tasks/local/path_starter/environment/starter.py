import os

def read_file(root: str, name: str):
    with open(root + "/" + name) as f:
        return f.read()
