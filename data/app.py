from flask import Flask, jsonify, request
from flask_cors import CORS
import time

app = Flask(__name__)
CORS(app)

longLat = [
  [77.711944, 11.342167],
  [77.711389, 11.342194],
  [77.710972, 11.342194],
  [77.710278, 11.342167],
  [77.709722, 11.342194],
  [77.709028, 11.342194],
  [77.708333, 11.342167],
  [77.707778, 11.342194],
  [77.707639, 11.342194]
]

flag = True
count = 0
busNumber = "TN 01 AA 0000"

@app.route('/')
def health():
    return jsonify({"status": "ok"})

@app.route('/data')
def data():
    global count
    count+=1
    return jsonify({
        "busNumber": busNumber,
        "latitude": longLat[count%9][1],
        "longitude": longLat[count%9][0],
        "timeStamp": time.strftime("%Y-%m-%d %H:%M:%S")
    })

@app.route('/change/bus', methods=['GET','POST'])
def changeBus():
    global busNumber

    if request.method == "POST":
        busNumber = request.form.get("busNumber", busNumber)

    return f"""
    <html>
        <body>
            <h2>Current Name: {busNumber}</h2>
            <form method="POST">
                <input type="text" name="busNumber" placeholder="Enter new bus number">
                <button type="submit">Update</button>
            </form>
        </body>
    </html>
    """

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)


"""
11°20'31.8"N 77°42'43.0"E
11°20'31.9"N 77°42'41.0"E
11°20'31.9"N 77°42'39.5"E

"""