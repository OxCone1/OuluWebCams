const delay = ms => new Promise(res => setTimeout(res, ms))
async function onpageload() {
    let start = 0
    let end = 4
    while (true) {
        if (sessionStorage.getItem("camerasInOulu") <= end) {
            start = 0
            end = 4
        }
        conditionalRender(start, end)
        start = end
        end = end + 4
        await delay(3000)
    }
}

function conditionalRender(startNum, endNum) {
    $.ajax({
    url: "https://api.oulunliikenne.fi/proxy/graphql",
    type: "POST",
    data: JSON.stringify({
        "operationName": "GetAllCameras",
        "variables": {},
        "query": "query GetAllCameras {cameras{cameraId,name,lat,lon,presets{presetId,presentationName,imageUrl,measuredTime}}}",
    }),
    contentType: "application/json",
    dataType: "json",
    success: function(data) {
        cameraArray = data.data.cameras
        let camerasInOulu = []
        let camerasInOulu_Clean = []
        cameraArray.forEach(element => {
            //if element.name contains "_Oulu_" push to array camerasInOulu
            if (element.name.includes("_Oulu_") || element.name.includes("-")) {
                camerasInOulu.push(element)
            }
        });
        camerasInOulu.forEach(element => {
            if (element.name.includes("Yli-Ii")) {
                //delete element
                let index = camerasInOulu.indexOf(element)
                camerasInOulu.splice(index, 1)
            }
        });
        camerasInOulu.forEach(element => {
            element.presets.forEach(camera => {
                camerasInOulu_Clean.push(camera)
            });
        });
        let now = new Date()
        camerasInOulu_noOld = []
        camerasInOulu_Clean.forEach((element, index) => {
            let tempValue = element.measuredTime
            let date = new Date(tempValue)
            let timeDiff = now.getTime() - date.getTime()
            let diffHours = timeDiff / 3600000
            if (diffHours < 4) {
                camerasInOulu_noOld.push(element)
            }
        });
        sessionStorage.setItem("camerasInOulu", camerasInOulu_noOld.length)
        camerasInOulu_noOld.forEach(element => {
            let date = new Date(element.measuredTime)
            let time = date.getDate() + "-" + (date.getMonth()+1) + "-" + date.getFullYear() + "  " + date.getHours() + ":" + date.getMinutes()
            element.measuredTime = time
        });
        //if camera time is more than 4 hours ago, delete camera
        for (let i = startNum; i < endNum; i=i+4) {
            for (let t = 1; t <= 4; t++) {
                $("#" + t).css("background-image", "url(" + camerasInOulu_noOld[i].imageUrl + ")")
                $("#" + t).find("h1").text(camerasInOulu_noOld[i].measuredTime)
                i++
            }
        }
    }
});
}
onpageload()
