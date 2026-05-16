#!/bin/bash

fuser -k 4000/tcp
fuser -k 8081/tcp
pkill -9 node